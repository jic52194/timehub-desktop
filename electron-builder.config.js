// electron-builder config for `npm run dist` and `npm run publish`.
//
// Partner Center product identity — Jared pastes the real strings after the
// company account is verified and the name is reserved. Do not invent a
// publisher GUID. The committed defaults are obvious placeholders.
//
// Paste into package.json → build.appx (the source of truth), or set the
// env vars below for one build without editing the file. `npm run dist`
// reads the env vars here. A bare `electron-builder` without `-c` this file
// uses only the package.json placeholders.
//
//   build.appx.identityName            TIMEHUB_APPX_IDENTITY_NAME
//     Partner Center → Product identity → Package / Identity / Name
//   build.appx.publisher                TIMEHUB_APPX_PUBLISHER
//     Package / Identity / Publisher, the full CN=... value, not the display name
//   build.appx.publisherDisplayName     TIMEHUB_APPX_PUBLISHER_DISPLAY_NAME
//     Package / Properties / Publisher display name
//
// applicationId stays TimeHub. Identity Name may start with a digit; the
// application id must not, so it is not copied from identityName.

const pkg = require('./package.json');
const { signWindows } = require('./scripts/sign-windows');

function envOr(name, fallback) {
  const value = process.env[name];
  if (value == null || !String(value).trim()) return fallback;
  return String(value).trim();
}

function checked(field, value, allowSpaces) {
  const text = value == null ? '' : String(value).trim();
  if (!text) {
    throw new Error('appx.' + field + ' is empty. Set package.json build.appx.' + field + ' or the matching TIMEHUB_APPX_* variable.');
  }
  if (/['"<>&]/.test(text)) {
    throw new Error('appx.' + field + ' contains a quote or XML markup character. Paste the Partner Center value with no extra quotes.');
  }
  if (!allowSpaces && /\s/.test(text)) {
    throw new Error('appx.' + field + ' cannot contain spaces. Paste the Partner Center value exactly.');
  }
  return text;
}

const baseAppx = pkg.build && pkg.build.appx;
if (!baseAppx) throw new Error('package.json build.appx is missing');

const appx = Object.assign({}, baseAppx, {
  identityName: checked('identityName', envOr('TIMEHUB_APPX_IDENTITY_NAME', baseAppx.identityName), false),
  publisher: checked('publisher', envOr('TIMEHUB_APPX_PUBLISHER', baseAppx.publisher), false),
  publisherDisplayName: checked(
    'publisherDisplayName',
    envOr('TIMEHUB_APPX_PUBLISHER_DISPLAY_NAME', baseAppx.publisherDisplayName),
    true
  )
});

const directories = Object.assign({ output: 'dist' }, (pkg.build && pkg.build.directories) || {});
if (process.env.TIMEHUB_BUILDER_OUTPUT && String(process.env.TIMEHUB_BUILDER_OUTPUT).trim()) {
  directories.output = String(process.env.TIMEHUB_BUILDER_OUTPUT).trim();
}

const win = Object.assign({}, pkg.build.win, { sign: signWindows });

module.exports = Object.assign({}, pkg.build, { appx, directories, win });
