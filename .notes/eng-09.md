# ENG-09: type checking without a build step: doc wording

## CLAUDE.md, "Engineering method, checks and tests" (new bullet)
- `npm run typecheck` (`scripts/typecheck.js`): TypeScript checks the pure core modules listed in `jsconfig.json` (`checkJs`, `noEmit`, `strict: false`) from their JSDoc, with no build step and no dependency: it runs `npx -y -p typescript@5 tsc -p jsconfig.json`, which fetches TypeScript into the npx cache, so it is not part of `npm run check` or `npm test` (both stay offline). Shared shapes (`Routine`, `RoutineSchedule`, `RoutineCheck`, `PersonaSummary`, `ScheduleEntry`, `ScheduleRepeat`) are in `main/types.d.ts` (never loaded at run time; use `@typedef {import('./types').Routine} Routine`). Fix its errors with JSDoc (`@param`, `@returns`, `@type` casts), never by changing behaviour. A new pure `main/*core.js` joins `include` once it checks clean; braincore stays out (it requires brains.js and so most of main/), and so do the `.mjs` wrappers (attachcore, chartcore, historycore, perfcore) until renderer/js is ready for it.

## CHANGELOG.md
- Type checking without a build step: `npm run typecheck` checks the pure core modules from their JSDoc (`jsconfig.json`, TypeScript fetched by npx, not a dependency); shared shapes such as a routine, a schedule entry and the persona summary are typed in `main/types.d.ts`.

## README.md, Develop section
- `npm run typecheck`: type-checks the pure core modules from their JSDoc (needs npx; fetches TypeScript into the npx cache the first time, adds no dependency).

## Notes for the reviewer
- Expression changes with identical behaviour, where JSDoc couldn't express it: Date/boolean subtraction wrapped in `Number(…)` (routinecore `check`, schedulecore `happensOn`/`occurrences`, worldcore `residents` sort). `Number(x) - Number(y)` is what `x - y` does for Dates and booleans.
- `maxNodeModuleJsDepth: 0`: otherwise @types/node's `import "string_decoder"` resolves to the npm package of that name and its JS gets checked.
