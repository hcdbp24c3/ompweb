import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  // `.worktrees/` holds full git worktrees, each with their own node_modules and
  // .next/. Both are already gitignored, but eslint does not read .gitignore, so
  // without this `eslint .` walks every build artifact in every worktree — slow,
  // and it reports findings in files that are not part of this checkout.
  { ignores: [".worktrees/**"] },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default eslintConfig;
