/** @type {import('next').NextConfig} */
module.exports = {
  experimental: {
    // pdfkit reads its built-in font files (e.g. data/Helvetica.afm) from its own folder at runtime. Bundled
    // into .next those files are missing and every GST document PDF fails (ENOENT), so it is loaded from
    // node_modules instead.
    serverComponentsExternalPackages: ['pdfkit'],
  },
};
