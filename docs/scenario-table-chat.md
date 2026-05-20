| id | repo | retention | sourceTB | gfs W/M/Y | copy | move | archive | plannedTB | perfTB | capTB | archTB | fullTB | incrTB | synthTB |
|---|---:|---:|---:|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| das-basic | DAS | 7 | 1 | 0/0/0 | False | False | False | 1.3902 |  |  |  | 0.6655 | 0.0333 | 0.0333 |
| das-retention-14 | DAS | 14 | 1 | 0/0/0 | False | False | False | 1.6231 |  |  |  | 0.6655 | 0.0333 | 0.0333 |
| sobr-moveonly | SOBR | 14 | 1 | 0/0/0 | False | True | False | 2.2553 | 1.3902 | 0.8652 | 0 | 0.6655 | 0.0333 | 0.0333 |
| sobr-copymove | SOBR | 21 | 1 | 0/0/0 | True | True | True | 2.7212 | 1.3902 | 1.331 | 0 | 0.6655 | 0.0333 | 0.0333 |
| das-gfs | DAS | 7 | 1 | 2/0/0 | False | False | False | 1.4565 |  |  |  | 0.6655 | 0.0333 | 0.0333 |
| sobr-gfs-archive | SOBR | 60 | 1 | 4/0/0 | False | True | True | 3.6529 | 1.3902 | 2.2627 | 0 | 0.6655 | 0.0333 | 0.0333 |
| das-monthly-2-small-r7 | DAS | 7 | 1 | 0/2/0 | False | False | False | 1.375 |  |  |  | 0.5 | 0.025 | 0.025 |
| das-yearly-2-small-r7 | DAS | 7 | 1 | 0/0/2 | False | False | False | 2.525 |  |  |  | 0.5 | 0.025 | 0.025 |
| das-monthly-2-large-r7 | DAS | 7 | 13.32 | 0/2/0 | False | False | False | 22.3296 |  |  |  | 6.66 | 0.666 | 0.666 |
| das-yearly-2-large-r7 | DAS | 7 | 13.32 | 0/0/2 | False | False | False | 42.3096 |  |  |  | 6.66 | 0.666 | 0.666 |
| das-mixed-2w1m-small-r7 | DAS | 7 | 1 | 2/1/0 | False | False | False | 1.225 |  |  |  | 0.5 | 0.025 | 0.025 |
| das-mixed-2w1y-small-r7 | DAS | 7 | 1 | 2/0/1 | False | False | False | 1.625 |  |  |  | 0.5 | 0.025 | 0.025 |
| das-mixed-1m1y-small-r7 | DAS | 7 | 1 | 0/1/1 | False | False | False | 1.675 |  |  |  | 0.5 | 0.025 | 0.025 |
| das-mixed-2w1m1y-small-r7 | DAS | 7 | 1 | 2/1/1 | False | False | False | 1.675 |  |  |  | 0.5 | 0.025 | 0.025 |
| das-mixed-2w1m1y-large-r7 | DAS | 7 | 13.32 | 2/1/1 | False | False | False | 30.3216 |  |  |  | 6.66 | 0.666 | 0.666 |
| sobr-mixed-2w1m1y-small-r60 | SOBR | 60 | 1 | 2/1/1 | False | True | True | 4.5905 | 1.3902 | 2.5621 | 0.6382 | 0.6655 | 0.0333 | 0.0333 |
| sobr-mixed-1m1y-small-r60 | SOBR | 60 | 1 | 0/1/1 | False | True | True | 4.5905 | 1.3902 | 2.5621 | 0.6382 | 0.6655 | 0.0333 | 0.0333 |
| sobr-copyonly-archive-gating | SOBR | 30 | 1 | 4/0/0 | True | False | True | 3.187 | 1.3902 | 1.7969 | 0 | 0.6655 | 0.0333 | 0.0333 |
| sobr-matrix-move-lt-retention | SOBR | 21 | 1 | 0/0/0 | False | True | False | 2.4882 | 1.3902 | 1.0981 | 0 | 0.6655 | 0.0333 | 0.0333 |
| sobr-matrix-move-eq-retention | SOBR | 14 | 1 | 0/0/0 | False | True | False | 1.3902 | 1.3902 | 0 | 0 | 0.6655 | 0.0333 | 0.0333 |
| sobr-matrix-move-gt-retention | SOBR | 14 | 1 | 0/0/0 | False | True | False | 1.3902 | 1.3902 | 0 | 0 | 0.6655 | 0.0333 | 0.0333 |
| sobr-matrix-move-zero | SOBR | 14 | 1 | 0/0/0 | False | True | False | 2.4882 | 1.3902 | 1.0981 | 0 | 0.6655 | 0.0333 | 0.0333 |
| lb-das-retention-count | DAS | 7 | 1 | 0/0/0 | False | False | False | 1.175 |  |  |  | 0.5 | 0.025 | 0.025 |
| lb-das-sla-overrides-count | DAS | 7 | 1 | 0/0/0 | False | False | False | 1.175 |  |  |  | 0.5 | 0.025 | 0.025 |
| lb-das-gfs-preserves-chain | DAS | 7 | 1 | 2/0/0 | False | False | False | 1.225 |  |  |  | 0.5 | 0.025 | 0.025 |
| lb-gfs-expiry-order | DAS | 7 | 1 | 2/0/0 | False | False | False | 1.225 |  |  |  | 0.5 | 0.025 | 0.025 |
| lb-gfs-monthly-boundary | DAS | 7 | 1 | 0/3/0 | False | False | False | 1.625 |  |  |  | 0.5 | 0.025 | 0.025 |
| lb-gfs-yearly-boundary | DAS | 7 | 1 | 0/0/2 | False | False | False | 2.363 |  |  |  | 0.5 | 0.025 | 0.025 |
| lb-gfs-stacking | DAS | 7 | 1 | 4/3/2 | False | False | False | 2.975 |  |  |  | 0.5 | 0.025 | 0.025 |
| lb-sobr-offload-threshold | SOBR | 14 | 1 | 0/0/0 | False | True | False | 1.825 | 1.175 | 0.65 | 0 | 0.5 | 0.025 | 0.025 |
| lb-sobr-archive-threshold-move | SOBR | 60 | 1 | 4/0/0 | False | True | True | 3.05 | 1.175 | 1.875 | 0 | 0.5 | 0.025 | 0.025 |
| lb-sobr-archive-threshold-copy | SOBR | 60 | 1 | 4/0/0 | True | False | True | 3.225 | 1.175 | 2.05 | 0 | 0.5 | 0.025 | 0.025 |
| lb-sobr-capacity-residue-after-archive | SOBR | 30 | 1 | 4/0/0 | True | False | True | 2.525 | 1.175 | 1.35 | 0 | 0.5 | 0.025 | 0.025 |
| lb-perf-prune-ordering | SOBR | 14 | 1 | 0/0/0 | False | True | False | 1.825 | 1.175 | 0.65 | 0 | 0.5 | 0.025 | 0.025 |
| ti-das-3yr-gfs-wmy | DAS | 14 | 1 | 4/3/2 | False | False | False | 3.2449 |  |  |  | 0.5788 | 0.0289 | 0.0289 |
| ti-sobr-move-3yr | SOBR | 30 | 1 | 4/3/0 | False | True | True | 3.6395 | 1.2138 | 1.6257 | 0.8 | 0.5788 | 0.0289 | 0.0289 |
| ti-sobr-copy-3yr | SOBR | 30 | 1 | 4/3/0 | True | False | True | 3.5917 | 1.2775 | 1.5107 | 0.8036 | 0.5788 | 0.0289 | 0.0289 |
| ti-sobr-gfs-archive-5yr | SOBR | 60 | 1 | 4/3/2 | False | True | True | 5.8085 | 1.2775 | 2.4013 | 2.1297 | 0.5788 | 0.0289 | 0.0289 |
| ti-das-sla-minimum-5yr | DAS | 14 | 1 | 4/3/2 | False | False | False | 3.2449 |  |  |  | 0.5788 | 0.0289 | 0.0289 |
| ti-das-chain-rp-drift-3yr | DAS | 14 | 1 | 4/3/2 | False | False | False | 3.2449 |  |  |  | 0.5788 | 0.0289 | 0.0289 |
| ti-sobr-move-chain-rp-drift-3yr | SOBR | 30 | 1 | 4/3/0 | False | True | True | 3.6395 | 1.2138 | 1.6257 | 0.8 | 0.5788 | 0.0289 | 0.0289 |
| ti-das-high-retention-drift-3yr | DAS | 30 | 1 | 4/3/2 | False | False | False | 3.8527 |  |  |  | 0.5788 | 0.0289 | 0.0289 |
| im-perf-immutability-blocks-prune | SOBR | 14 | 1 | 0/0/0 | False | True | False | 1.825 | 1.175 | 0.65 | 0 | 0.5 | 0.025 | 0.025 |
| im-cap-immutability-blocks-deletion | SOBR | 14 | 1 | 0/0/0 | False | True | False | 1.825 | 1.175 | 0.65 | 0 | 0.5 | 0.025 | 0.025 |
| im-arch-immutability-blocks-deletion | SOBR | 30 | 1 | 2/0/0 | False | True | True | 2.35 | 1.175 | 1.175 | 0 | 0.5 | 0.025 | 0.025 |
| im-gen-window-boundary | SOBR | 14 | 1 | 0/0/0 | False | True | False | 1.825 | 1.175 | 0.65 | 0 | 0.5 | 0.025 | 0.025 |
| im-gen-deleteon-extended-by-gfs | SOBR | 14 | 1 | 4/0/0 | False | True | False | 2.225 | 1.175 | 1.05 | 0 | 0.5 | 0.025 | 0.025 |
| im-gen-state-transitions | SOBR | 14 | 1 | 2/0/0 | False | True | False | 1.825 | 1.175 | 0.65 | 0 | 0.5 | 0.025 | 0.025 |
| im-all-tiers-immutability | SOBR | 30 | 1 | 2/0/0 | False | True | True | 2.35 | 1.175 | 1.175 | 0 | 0.5 | 0.025 | 0.025 |
| ix-gfs-wmy-move-archive | SOBR | 60 | 1 | 4/3/2 | False | True | True | 5.01 | 1.175 | 2.075 | 1.76 | 0.5 | 0.025 | 0.025 |
| ix-gfs-wmy-copy-archive | SOBR | 60 | 1 | 4/3/2 | True | False | True | 4.85 | 1.175 | 1.925 | 1.75 | 0.5 | 0.025 | 0.025 |
| ix-gfs-wmy-copy-archive-immutability | SOBR | 60 | 1 | 4/3/2 | True | False | True | 4.85 | 1.175 | 1.925 | 1.75 | 0.5 | 0.025 | 0.025 |
| ix-gfs-monthly-move-immutability | SOBR | 30 | 1 | 0/3/0 | False | True | False | 2.8 | 1.145 | 1.655 | 0 | 0.5 | 0.025 | 0.025 |
| ix-short-retention-long-gfs | DAS | 7 | 1 | 0/0/5 | False | False | False | 3.155 |  |  |  | 0.5 | 0.025 | 0.025 |
| ix-high-gen-period | SOBR | 60 | 1 | 0/3/0 | False | True | False | 3.325 | 1.145 | 2.18 | 0 | 0.5 | 0.025 | 0.025 |
| ix-copy-move-combo | SOBR | 30 | 1 | 4/2/0 | True | True | True | 2.842 | 1.145 | 1.27 | 0.427 | 0.5 | 0.025 | 0.025 |
| ix-no-gfs-long-archive | SOBR | 30 | 1 | 0/0/0 | False | True | True | 2.175 | 1.175 | 1 | 0 | 0.5 | 0.025 | 0.025 |
| ix-retention-variant-r7 | SOBR | 7 | 1 | 4/3/0 | False | True | True | 2.8585 | 1.145 | 0.83 | 0.8835 | 0.5 | 0.025 | 0.025 |
| ix-retention-variant-r60 | SOBR | 60 | 1 | 4/3/2 | False | True | True | 5.01 | 1.175 | 2.075 | 1.76 | 0.5 | 0.025 | 0.025 |
| ix-high-change-rate-drift-2yr | DAS | 14 | 1 | 4/3/1 | False | False | False | 7.137 |  |  |  | 0.5 | 0.2 | 0.2 |
| ix-short-retention-drift-3yr | DAS | 3 | 1 | 4/3/1 | False | False | False | 1.967 |  |  |  | 0.5 | 0.025 | 0.025 |
| ix-policy-change-mid-run | DAS | 7 | 1 | 4/3/0 | False | False | False | 1.625 |  |  |  | 0.5 | 0.025 | 0.025 |
| ix-gfs-only-policy | DAS | 1 | 1 | 52/0/0 | False | False | False | 26.225 |  |  |  | 0.5 | 0.025 | 0.025 |
| ix-two-jobs-one-repo | DAS | 14 | 1 | 4/2/0 | False | False | False | 1.55 |  |  |  | 0.5 | 0.025 | 0.025 |
| od-weekly-gfs-cardinality-exact | DAS | 14 | 1 | 4/0/0 | False | False | False | 1.65 |  |  |  | 0.5 | 0.025 | 0.025 |
| od-monthly-yearly-cardinality-exact | DAS | 14 | 1 | 0/3/2 | False | False | False | 2.934 |  |  |  | 0.5 | 0.025 | 0.025 |
| od-tier-residency-per-point | SOBR | 30 | 1 | 4/0/0 | False | True | True | 2.35 | 1.175 | 1.175 | 0 | 0.5 | 0.025 | 0.025 |
| od-gen-lifecycle-states | SOBR | 30 | 1 | 4/0/0 | False | True | False | 2.35 | 1.175 | 1.175 | 0 | 0.5 | 0.025 | 0.025 |
| od-chain-phase-transitions | SOBR | 21 | 1 | 2/0/0 | False | True | False | 2 | 1.175 | 0.825 | 0 | 0.5 | 0.025 | 0.025 |
| od-sobr-copy-full-lifecycle | SOBR | 30 | 1 | 4/3/0 | True | False | True | 3.097 | 1.175 | 1.225 | 0.697 | 0.5 | 0.025 | 0.025 |
