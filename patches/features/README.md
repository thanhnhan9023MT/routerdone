# Feature Patches

Small feature patches live here and are applied after `patches/routerdone-custom.patch`.

Keep new changes as separate focused patches so upstream updates are easier to verify:

```sh
git apply patches/routerdone-custom.patch
git apply --check patches/features/<feature>.patch
```

The Docker build applies files in this folder in shell glob order after the base patch.
