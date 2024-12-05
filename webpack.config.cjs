/* eslint-disable @typescript-eslint/no-var-requires */
// Needs to remain CommonJS until eslint-import-resolver-webpack supports ES modules
const webpack = require("./build-scripts/webpack.cjs");
const env = require("./build-scripts/env.cjs");

// This file exists because we haven't migrated the stats script yet

const configs = [
  {
    ...webpack.createAppConfig({
      isProdBuild: env.isProdBuild(),
      isStatsBuild: env.isStatsBuild(),
      isTestBuild: env.isTestBuild(),
      latestBuild: true,
    }),
    externals: {
      // only define the dependencies you are NOT using as externals!
      canvg: "canvg",
      html2canvas: "html2canvas",
      dompurify: "dompurify",
    },
  },
];

if (env.isProdBuild() && !env.isStatsBuild()) {
  configs.push({
    ...webpack.createAppConfig({
      isProdBuild: env.isProdBuild(),
      isStatsBuild: env.isStatsBuild(),
      isTestBuild: env.isTestBuild(),
      latestBuild: false,
    }),
    externals: {
      // only define the dependencies you are NOT using as externals!
      canvg: "canvg",
      html2canvas: "html2canvas",
      dompurify: "dompurify",
    },
  });
}

module.exports = configs;
