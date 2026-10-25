// NSIS may be Authenticode-signed when CSC_LINK is set. The Store appx must
// not be: Partner Center re-signs it, and the Identity Publisher (a Partner
// Center CN) will not match that certificate's subject.

const path = require('path');

function isStorePackage(file) {
  return /\.appx$/i.test(String(file || ''));
}

async function signWindows(configuration, packager) {
  const file = configuration && configuration.path;
  if (isStorePackage(file)) {
    console.log('Leaving Store appx unsigned so Partner Center can re-sign: ' + path.basename(file));
    return;
  }
  if (!configuration || !configuration.cscInfo) return;
  const { doSign } = require('app-builder-lib/out/codeSign/windowsCodeSign');
  return doSign(configuration, packager);
}

module.exports = { isStorePackage, signWindows };
