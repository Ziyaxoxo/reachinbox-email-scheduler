import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        // Neutral text + surfaces (Figma: near-black ink on off-white)
        ink: {
          DEFAULT: "#1b1e1c",
          900: "#141715",
          700: "#3d423f",
          soft: "#3d423f",
          500: "#767b77",
          muted: "#767b77",
          400: "#9aa09b",
          faint: "#9aa09b",
          300: "#b9bfba",
        },
        surface: {
          DEFAULT: "#ffffff",
          muted: "#f7f8f7",
          sunken: "#f1f2f1",
          input: "#f4f5f4",
        },
        line: {
          DEFAULT: "#e7e9e7",
          strong: "#d8dbd8",
        },
        // Accent green (Figma primary: mint tints + emerald solids)
        brand: {
          50: "#eafaf0",
          100: "#d6f4e2",
          200: "#aee9c7",
          300: "#7bd9a5",
          400: "#45c481",
          500: "#22c55e",
          600: "#16a34a",
          700: "#15803d",
          800: "#166534",
          900: "#14532d",
        },
        warn: {
          50: "#fff4e5",
          100: "#ffe6c7",
          500: "#e08b1a",
          600: "#c2760f",
        },
        danger: {
          50: "#fdeeee",
          100: "#fbdbdb",
          500: "#dc4b4b",
          600: "#c23b3b",
        },
      },
      fontFamily: {
        sans: ["var(--font-ui)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      borderRadius: {
        card: "10px",
        ctl: "8px",
        pill: "999px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(20, 23, 21, 0.04)",
        pop: "0 12px 32px -8px rgba(20, 23, 21, 0.16)",
        focus: "0 0 0 3px rgba(34, 197, 94, 0.18)",
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
    },
  },
  plugins: [],
};

export default config;
