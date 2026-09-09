# Redrix EC maintenance

Forkit maintains `codgician/redrix-ec` from Chromium's `ec-legacy` branch.
`ec-legacy` is an exact branch mirror. `my` is generated from the same upstream
commit with these independent patches, in order:

| Patch branch | Source | Effect |
| --- | --- | --- |
| `patches/mkbp-host-events` | acd407/chrome-ec `6f62e771fa`, local `d64cf00371` | Send MKBP host events while awake as well as suspended, retaining GPIO delivery. |
| `patches/mkbp-sci-mask` | acd407/chrome-ec `13bf68370e`, local `359396b4d4`, plus local mkbp2 correction | Add MKBP to the SCI mask at initialization and resume using `EC_HOST_EVENT_MASK`, preserving the other mask bits. |
| `patches/backlight-sysjump` | acd407/chrome-ec `17553c9cf6b8b67fecebb2a76378a5ce6e64a68f` | Restore backlight driver registration after an awake sysjump without resetting PWM hardware. |

Each patch is based on official commit
`b5f7b64a1d8f86b82f8e1ea6290d97a2dedea12d`. Their combined runtime diff is
three C files, 52 additions and 8 deletions. The inventory comes from the
existing local `PATCHES.md` and its reviewed `runtime-vs-upstream.patch`.
The USB-PD AP-mode-entry override is excluded, as it was excluded from mkbp2.

These patches are intentionally permanent (`cleanup: manual`). Edit their
branches to maintain them; do not put durable edits directly on generated `my`.
When rebasing a patch branch, update its explicit base in `forkit.yaml` too.
A conflict fails `my` while the unpatched `ec-legacy` mirror may still advance.

## Validation

`validate.sh` builds an exported source tree with pinned nixpkgs, host GCC 13,
and Arm GNU Toolchain 13.3.Rel1. Native tests additionally use pinned Chromium
`cryptoc`. Build-only shebang and host termios adaptations stay in the disposable
archive. The pipeline performs:

- Redrix firmware compilation and RW size, identity, and hook-symbol checks.
- Native `lid_sw` and `kb_mkbp` tests.
- The production-source backlight regression test, including a negative control
  with the sysjump registration hook removed.

Build identity is `redrix-forkit-<composed commit prefix>` and is only used for
validation. The pipeline publishes source branches, not firmware binaries, and
never flashes hardware. Current `ec-legacy` plus these patches is not a rebuild
of the historical, fixed-base mkbp2 image. Hardware behavior and compatibility
with an installed RO image require separate testing before deployment.

Run the workflow with `repository=codgician/redrix-ec` and `dry_run=true` to
validate; use `dry_run=false` to publish successful targets.
