const packageMetadata = require('../package.json');

const PRODUCT_FAMILY_NAME = 'OpenOPC';
const displayName = packageMetadata.productName || PRODUCT_FAMILY_NAME;

const PRODUCT_BRAND = Object.freeze({
  displayName,
  desktopName: `${displayName} Desktop`,
  localNodeName: `${displayName} Local Execution`,
});

const LEGACY_DESKTOP_IDENTIFIERS = Object.freeze({
  urlScheme: 'kortix',
  userAgentToken: 'KortixDesktop/0.1.0',
  userDataName: 'Kortix Desktop',
});

function openOpcEnv(name, legacyName, env = process.env) {
  return env[name] || env[legacyName] || undefined;
}

function legacyUserDataName(visibleName = displayName) {
  if (visibleName === PRODUCT_FAMILY_NAME) return LEGACY_DESKTOP_IDENTIFIERS.userDataName;
  if (visibleName.startsWith(`${PRODUCT_FAMILY_NAME} `)) {
    return `Kortix ${visibleName.slice(PRODUCT_FAMILY_NAME.length + 1)} Desktop`;
  }
  return `${visibleName} Desktop`;
}

module.exports = {
  LEGACY_DESKTOP_IDENTIFIERS,
  PRODUCT_BRAND,
  legacyUserDataName,
  openOpcEnv,
};
