# Loader correction before inference

The first launch stopped in `snapshot_download`, before the model was loaded or
any case was scored. Offline Hugging Face requires an explicit allow-list for a
partially provisioned repository (only the English checkpoint was cached).

The study loader was corrected to request the same four file patterns as the
production service. No candidate, label, split, selection rule or acceptance gate
changed. No development/test predictions existed. `pre-inference-manifest.json`
retains the original freeze; the active manifest was regenerated before retrying.
