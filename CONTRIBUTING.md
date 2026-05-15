# Contributing

Thanks for taking an interest. A few things to know before you open a PR.

## Project Constraints

This project has hard constraints that shape every decision:

- **2MB shipped size ceiling.** No frameworks, no bundlers, no large dependencies. The piece must work on slow connections.
- **Zero runtime dependencies.** The shipped code is vanilla HTML, CSS, and JavaScript. No npm install is needed to run anything.
- **No build step.** Files are served as-is. If your change introduces a build step, it probably doesn't belong here.

If a change you want to make conflicts with one of these, open an issue first to discuss before writing code.

## Development Setup

```
npm start
```

That runs `npx serve .` and opens a local static server. No installs, no dependencies. Open `demo.html` for the single-line study or `wall.html` for the stacked wall.

The original baseline prototype lives in `prototype/prototype.html` and is the visual source of truth for line behavior. Do not modify it; it is preserved as a reference.

## Code Style

- Match the existing style of the file you're editing.
- No comments that restate what the code does. Comments explain the *why* — a hidden constraint, a tuned constant, a workaround.
- Don't rename "magic numbers" into named constants without preserving what they were tuned for. Many numbers in `engine.js` are the result of many iterations.

## Commit Conventions

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>
```

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `build`, `ci`, `perf`, `revert`.

Examples:

```
feat(wall): add uneven-decay fade
fix(engine): correct slant accumulation
docs: clarify line-height computation
```

## Pull Request Process

1. Fork and create a branch: `type/kebab-case-description` (e.g., `feat/mobile-touch-input`).
2. Make your changes. Keep PRs focused — one concern per PR.
3. Push and open a PR against `main`. Fill in the PR template.
4. CI runs automatically and verifies that HTML files parse cleanly and JavaScript files have valid syntax.
5. A maintainer will review. Address feedback by pushing new commits to the branch (do not force-push during review).

## What Belongs Here

This project is a specific piece, not a generic framework. Contributions that fit:

- Bug fixes
- Browser compatibility
- Accessibility improvements
- Performance work that doesn't change the visual language
- Documentation

Contributions that probably don't fit without prior discussion:

- New visual features ("what if strokes had colors?")
- New input modalities beyond what's already on the roadmap (mobile is planned; other input devices are not)
- Generalising the engine into a framework
- Anything that adds dependencies

When in doubt, open an issue.
