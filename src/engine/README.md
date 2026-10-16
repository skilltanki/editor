# Engine copy

A copy of the engine modules the editor needs (`math/Vector3`, `Matrix3`, `Matrix4`,
`map/Parser3DS`, `PropLibrary`, `xmlUtils`, `render/buildMesh`), taken as is from
`apps/mobile/src/engine`. Packages never import each other's files: the editor builds,
typechecks and breaks on its own. Keep behaviour identical to the game's copy; when the
game's copy changes, re-copy the file rather than patching it here.
