/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: "/api/v1/:path*",
        destination: `${process.env.API_URL || "http://localhost:3000"}/api/v1/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
