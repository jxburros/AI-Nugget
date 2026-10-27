# Consumer rollout for 0.7.5

The provider/cloud release keeps existing connections compatible. Consumer
updates use an exact source commit or a regenerated vendor artifact until 0.7.5
is published; do not depend on a nonexistent npm version. Release publication
still uses the main-branch manual Release action after its dry run.

| Consumer | Adoption change |
|---|---|
| AI-Server-Studio | Update backend package; retain Meta/error/short-key workarounds because their corresponding audit fixes were not selected |
| Astra-log | Update package and Node requirement; retain model capability fallbacks until richer discovery lands |
| QAI-ality | Refresh vendor copy; forward reported usage/finish/timing through the bridge; update install guidance |
| Issues-Handler | Update package and use existing chatParsed validation; regenerate committed action bundle |
| AI-Chatbot | Refresh compiled vendor copy; retain its import path; update historical integration notes |
| Secret-Census | Refresh vendor copy; omit dummy credentials for keyless local calls |
| Test-App | Update package; check demo and agent exports |
| Design-Profiles | Replace the stale browser CDN pin with the reviewed source commit |
| Game-Vault | Update the request/type dependency and build |
| AI-Context-Nugget | Run interoperability examples against the packed artifact; no runtime dependency change required |

Each consumer PR records its own validation. Package pins can move to the public
npm release after publication without changing the application integration.
Live provider tests require separately configured test credentials; fixture and
build success does not establish live verification.

## Review and validation — 2026-10-27

The nine adoption PRs pin source commit
`f8e563fd6c23957b0885e131c5aac4e9a7851693` (including the Converse binary
reasoning replay fix). Each is a draft; no release has been published or merged.

| Adoption PR | Validation / limitations |
|---|---|
| [Astra-log](https://github.com/jxburros/Astra-log/pull/297) | Passed npm test (19 Node tests, 123 component tests and typecheck) and npm run build; aligned the Node requirement and integration guide. |
| [Issues-Handler](https://github.com/jxburros/Issues-Handler/pull/188) | Passed all 94 Jest tests, including real-package corrective JSON retry and exhausted validation, and regenerated the ncc action bundle. chatJson now uses chatParsed; domain validation remains at call sites. |
| [AI-Chatbot](https://github.com/jxburros/AI-Chatbot/pull/45) | Passed npm run lint and the Next.js production build. Excluded generated upstream vendor artifacts from application linting and annotated historical integration notes. |
| [Secret-Census](https://github.com/jxburros/Secret-Census/pull/224) | Passed npm test (103 tests and typecheck) and npm run build. Keyless local/custom connections now use keyRef kind none instead of a dummy credential. |
| [Test-App](https://github.com/jxburros/Test-App/pull/36) | Passed npm run build (TypeScript and Vite); root and agent exports resolve from the pinned package. |
| [Design-Profiles](https://github.com/jxburros/Design-Profiles/pull/43) | Passed all 43 tests and loaded the pinned root and /agent CDN modules in headless Chromium. |
| [Game-Vault](https://github.com/jxburros/Game-Vault/pull/49) | npm ci passed. npm run build reports 197 existing media/storage TypeScript errors; a clean origin/main worktree produces the identical diagnostics. The dependency change introduces no additional diagnostics. |
| [QAI-ality](https://github.com/jxburros/QAI-ality/pull/851) | Passed 21 focused bridge/config-parser tests, including reported token usage, and release validation. Full JavaScript suite: 1,554 passed, 9 skipped, 3 process-cleanup failures also reproduced on unchanged origin/main. PowerShell tests skipped because pwsh is unavailable. The vendor, usage bridge, notices and install guidance are updated. |
| [AI-Server-Studio](https://github.com/jxburros/AI-Server-Studio/pull/1974) | Passed backend typecheck, build, 36 focused Nugget/provider/dispatch tests and release validation; live calls and native desktop/GPU checks were not run. |

AI-Context-Nugget required no source change: its 108 tests passed, and an
additional offline request exercised its packed-context messages/metadata with
the packed AI Nugget artifact. The core suite passes 286 tests in Node and 286
in Chromium; six credential-gated tests are skipped. The QAI parser accepts all
13 levels in `.ai/qa.yaml` with no configuration problems. `npm audit` reports
zero vulnerabilities for the core dependency tree.
