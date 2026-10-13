// The app runs the Gilded Spines page from assets/web, so Metro has to bundle
// .html files as assets.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push('html');

module.exports = config;
