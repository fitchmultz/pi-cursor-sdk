# SDK capture provenance — 2026-08-02

- The installed extension used exact `@cursor/sdk@1.0.23`.
- The authenticated model-catalog refresh fetched 34 models using the same SDK.
- The npm registry's current SDK release at the time was 1.0.26. The capture targeted 1.0.23 because the extension then pinned and validated that runtime. Raising the runtime dependency was outside the catalog refresh.
