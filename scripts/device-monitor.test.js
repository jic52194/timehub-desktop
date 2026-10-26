// Plain-Node test for device-monitor.js. A temp folder stands in for a USB
// drive; a fake drive source "plugs" and "unplugs" it. Run by scripts/smoke.js.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DeviceMonitor, shouldIgnore, extOf, parseDrivesLine, powershellScript } = require('../device-monitor');

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  // Pure helpers.
  assert.strictEqual(extOf('Payroll Q3.XLSX'), 'xlsx');
  assert.strictEqual(extOf('README'), null);
  assert.ok(shouldIgnore('System Volume Information\\IndexerVolumeGuid'));
  assert.ok(shouldIgnore('$RECYCLE.BIN\\S-1-5\\x.csv'));
  assert.ok(shouldIgnore('~$Report.xlsx'));
  assert.ok(shouldIgnore('folder\\Thumbs.db'));
  assert.ok(!shouldIgnore('clients\\leads.csv'));

  const parsed = parseDrivesLine('DRIVES [{"id":"e:","label":"KINGSTON","size":31000000000,"fs":"FAT32","type":2},{"id":"bad"}]');
  assert.strictEqual(parsed.length, 1);
  assert.deepStrictEqual(parsed[0], { id: 'E:', root: 'E:\\', label: 'KINGSTON', size: 31000000000, fs: 'FAT32', bus: 'removable' });
  const single = parseDrivesLine('DRIVES {"id":"F:","label":null,"size":1,"fs":"NTFS","type":3}');
  assert.strictEqual(single[0].bus, 'usb-disk');
  assert.deepStrictEqual(parseDrivesLine('DRIVES []'), []);
  assert.strictEqual(parseDrivesLine('noise'), null);
  assert.ok(powershellScript(123).includes('$parent = 123'));

  // Live watch on a temp "drive".
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'th-usb-'));
  fs.writeFileSync(path.join(root, 'old.txt'), 'already here');
  const past = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(path.join(root, 'old.txt'), past, past);

  await wait(250); // old.txt existed before the drive was "plugged in"

  let push = null;
  const source = { start(onList) { push = onList; }, stop() { push = null; } };
  const mon = new DeviceMonitor({ source: source, settleMs: 300, freshSlackMs: 0 });
  const events = [];
  mon.on('event', (e) => events.push(e));
  mon.start();
  const drive = { id: 'T:', root: root, label: 'TESTDRIVE', size: 1000, fs: 'NTFS', bus: 'removable' };

  push([drive]);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].kind, 'usb_connected');
  assert.strictEqual(events[0].drive_label, 'TESTDRIVE');
  assert.strictEqual(events[0].details.already_connected, true);
  push([drive]); // same drive again: no new event
  assert.strictEqual(events.length, 1);

  await wait(300);
  fs.mkdirSync(path.join(root, 'exports'));
  fs.writeFileSync(path.join(root, 'exports', 'leads.csv'), 'a,b\n1,2\n');
  fs.writeFileSync(path.join(root, 'song.mp3'), Buffer.alloc(2048));
  fs.writeFileSync(path.join(root, '~$lock.xlsx'), 'x');
  fs.readFileSync(path.join(root, 'old.txt')); // read only: must not count
  await wait(1500);

  const copies = events.filter((e) => e.kind === 'file_copied');
  const names = copies.map((e) => e.file_name).sort();
  assert.deepStrictEqual(names, ['leads.csv', 'song.mp3'], 'copied files: ' + JSON.stringify(names));
  const csv = copies.find((e) => e.file_name === 'leads.csv');
  assert.strictEqual(csv.file_ext, 'csv');
  assert.strictEqual(csv.size_bytes, 8);
  assert.strictEqual(csv.drive_letter, 'T:');
  assert.strictEqual(csv.details.folder_depth, 1);
  assert.ok(!('contents' in csv));
  assert.ok(!Number.isNaN(Date.parse(csv.occurred_at)));

  // Same file touched again with no change: no duplicate.
  const before = copies.length;
  fs.utimesSync(path.join(root, 'song.mp3'), fs.statSync(path.join(root, 'song.mp3')).atime, fs.statSync(path.join(root, 'song.mp3')).mtime);
  await wait(800);
  assert.strictEqual(events.filter((e) => e.kind === 'file_copied').length, before);

  // Unplug.
  push([]);
  const removed = events.filter((e) => e.kind === 'usb_removed');
  assert.strictEqual(removed.length, 1);
  assert.strictEqual(removed[0].details.files_seen, 2);
  assert.deepStrictEqual(mon.drives(), []);

  // Plug again later: not "already connected".
  push([drive]);
  const reconnect = events.filter((e) => e.kind === 'usb_connected');
  assert.strictEqual(reconnect.length, 2);
  assert.strictEqual(reconnect[1].details.already_connected, false);

  mon.stop();
  assert.strictEqual(push, null, 'source stopped');
  // Writes after stop are not reported.
  const count = events.length;
  fs.writeFileSync(path.join(root, 'after-stop.csv'), 'x');
  await wait(800);
  assert.strictEqual(events.length, count);

  fs.rmSync(root, { recursive: true, force: true });

  // Downloads folder: new files are file_downloaded; partial downloads and
  // files that were already there are not.
  const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'th-dl-'));
  fs.writeFileSync(path.join(dl, 'earlier.pdf'), 'x');
  await wait(250);
  const mon2 = new DeviceMonitor({ source: { start() {}, stop() {} }, settleMs: 300, freshSlackMs: 0, folders: [{ root: dl, label: 'Downloads' }] });
  const ev2 = [];
  mon2.on('event', (e) => ev2.push(e));
  mon2.start();
  await wait(300);
  fs.writeFileSync(path.join(dl, 'customers.xlsx.crdownload'), Buffer.alloc(100));
  fs.renameSync(path.join(dl, 'customers.xlsx.crdownload'), path.join(dl, 'customers.xlsx'));
  fs.readFileSync(path.join(dl, 'earlier.pdf'));
  await wait(1200);
  assert.deepStrictEqual(ev2.map((e) => e.kind + ':' + e.file_name), ['file_downloaded:customers.xlsx'], JSON.stringify(ev2));
  assert.strictEqual(ev2[0].drive_label, 'Downloads');
  assert.strictEqual(ev2[0].drive_letter, null);
  assert.strictEqual(ev2[0].file_ext, 'xlsx');
  assert.strictEqual(ev2[0].size_bytes, 100);
  mon2.stop();
  fs.writeFileSync(path.join(dl, 'after.csv'), 'x');
  await wait(600);
  assert.strictEqual(ev2.length, 1, 'no events after stop');
  fs.rmSync(dl, { recursive: true, force: true });
  console.log('device-monitor: ok (' + events.length + ' events)');
}

main().catch((err) => {
  console.error('device-monitor: FAILED\n' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
