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
