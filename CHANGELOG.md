# Changelog

All notable changes to this project are documented here.

## 0.1.0-alpha.1 - Public preview

### Added
- Renamed the package identity to `@marckrenn/pi-lab` and updated project metadata and examples to the new repository path.
- Added release notes for `0.1.0-alpha.1` with guidance on the git-first preview install flow.
- Added a dedicated MIT license file (`LICENSE`).

### Major caveats
- **API/format stability is not guaranteed**: configuration schema, extension loading behavior, and telemetry artifacts are still expected to evolve before a 1.0 release.
- **Operational maturity is limited**: no enterprise rollout policies, no remote governance layer, and no centralized telemetry service.
- **Security remains explicit**: lane extensions are local code paths and execute with your local workspace privileges.
- **Production hardening pending**: there is no long-term support guarantee for alpha compatibility, and breaking changes may occur on patch/minor versions.
- **Cost/performance trade-offs**: multi-lane execution can increase API spend, latency, and local resource usage compared with single-lane workflows.
