# Contributing

Thanks for helping improve the project. Small, reproducible changes to evidence validation, reporting and failure handling are especially useful.

1. Open an issue describing the behavior and a synthetic reproduction, or start a focused pull request.
2. Use Node.js 20.20+ and install with `npm ci --ignore-scripts`.
3. Run `npm run check`, `npm test`, `npm run demo` and `npm run check:public` after staging new files.
4. Explain what changed, why it matters and how you verified it. Include a synthetic screenshot for report changes.

Keep market timestamps and receipt timestamps distinct. Preserve unavailable evidence; do not substitute later observations or a convenient default. Changes to execution gates, risk rules or position ownership need tests for their failure paths and a clear explanation of the changed behavior.

Do not submit account numbers, tokens, approved local policies, trading journals, private strategy records or third-party code without compatible licensing. Use invented fixtures. Report security problems privately as described in [SECURITY.md](SECURITY.md).

Be respectful and focus feedback on the work. Maintainers may close abusive or unrelated contributions. By contributing, you agree that your original contribution is available under this repository's MIT license.
