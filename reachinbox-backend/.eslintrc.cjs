module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    // Type-aware linting. `no-misused-promises` is the reason this is on: it can
    // only tell a genuinely floating promise from a handler whose return value
    // Express uses, and it needs the type checker to do that. Set to false
    // instead, the rule is right about almost every Express handler in the
    // project and wrong about all of them at once.
    project: ["./tsconfig.json"],
    tsconfigRootDir: __dirname,
  },
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
  ],
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: ["dist/", "node_modules/", "migrations/", "*.cjs"],
  rules: {
    // TypeScript already reports these, and it does it with type information,
    // which the ESLint rule does not have. Duplicating them here would produce
    // a second, weaker version of the same error.
    "no-undef": "off",
    "no-unused-vars": "off",
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],

    // Express handlers are typed as returning void but the framework uses the
    // return value, so the rule misreads every handler that returns `res`.
    "@typescript-eslint/no-misused-promises": [
      "error",
      { checksVoidReturn: { arguments: false, attributes: false } },
    ],

    // Enabled because the codebase already passes it, and because in a queue
    // app an unawaited write is a silently lost one: the process moves on and
    // the row is never written. `ignoreVoid` accepts the `void` operator, which
    // is how this codebase marks a deliberately unawaited call.
    "@typescript-eslint/no-floating-promises": [
      "error",
      { ignoreVoid: true, ignoreIIFE: true },
    ],

    // `any` is banned in favour of `unknown` plus a narrowing check, which is
    // what the existing code already does. A few unavoidable spots are listed
    // in the overrides below rather than switched off repo-wide.
    "@typescript-eslint/no-explicit-any": "error",

    eqeqeq: ["error", "always", { null: "ignore" }],
    "no-console": ["error", { allow: ["error", "warn"] }],

    // The rule exists to catch control characters used to slip past a parser.
    // Here matching them is the whole job: C0 control characters are stripped
    // from email bodies so they cannot be used to disguise markup in a mail
    // client. Not an exemption, a use of the feature.
    "no-control-regex": "off",
  },
  overrides: [
    {
      // Startup and migration code runs before the logger is configured, so it
      // reports to the console deliberately: it is the only output available if
      // the process is about to exit.
      files: ["src/config/env.ts", "src/db/migrate.ts"],
      rules: { "no-console": "off" },
    },
    {
      // Tests assert on deliberately malformed input, so `any` is the point.
      files: ["src/**/*.test.ts", "src/tests/**/*.ts"],
      rules: {
        "@typescript-eslint/no-explicit-any": "off",
        "@typescript-eslint/no-non-null-assertion": "off",
        // These are harnesses: printing each check as it runs is the output.
        "no-console": "off",
      },
    },
    {
      // Manual probes and load harnesses, likewise run from a terminal.
      files: ["scripts/**"],
      rules: { "no-console": "off" },
    },
  ],
};
