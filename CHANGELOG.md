# Changelog

## [0.5.1](https://github.com/protomated/youtrackd/compare/youtrackd-v0.5.0...youtrackd-v0.5.1) (2026-04-16)


### Bug Fixes

* add fade-out animation when marking notifications as read ([cbfa4d9](https://github.com/protomated/youtrackd/commit/cbfa4d99c624d14285c16fb9f2719015ced045e7))

## [0.5.0](https://github.com/protomated/youtrackd/compare/youtrackd-v0.4.3...youtrackd-v0.5.0) (2026-04-15)


### Features

* unread-by-default feed, rich field-change descriptions, assignee-to-me highlighting ([e9f178d](https://github.com/protomated/youtrackd/commit/e9f178d958a8ccf5c33dcbb2c66b24a6d97a7480))

## [0.4.3](https://github.com/protomated/youtrackd/compare/youtrackd-v0.4.2...youtrackd-v0.4.3) (2026-04-11)


### Bug Fixes

* auto mark-as-read when replying to a notification ([b8cedd0](https://github.com/protomated/youtrackd/commit/b8cedd06c8c5f6e5216882ee65c9a706b6f61f96))

## [0.4.2](https://github.com/protomated/youtrackd/compare/youtrackd-v0.4.1...youtrackd-v0.4.2) (2026-04-10)


### Bug Fixes

* toolbar unread count not updating on mark-as-read ([3f931e8](https://github.com/protomated/youtrackd/commit/3f931e858a0cb11e1a1fcdf5214f288b3fd772d2))

## [0.4.1](https://github.com/protomated/youtrackd/compare/youtrackd-v0.4.0...youtrackd-v0.4.1) (2026-04-09)


### Bug Fixes

* mark-as-read not updating UI after multi-account refactor ([cbaece7](https://github.com/protomated/youtrackd/commit/cbaece7dab127d0fbc665f4bb7720de1f6919e38))

## [0.4.0](https://github.com/protomated/youtrackd/compare/youtrackd-v0.3.1...youtrackd-v0.4.0) (2026-04-07)


### Features

* add multi-account support for multiple YouTrack instances ([424042c](https://github.com/protomated/youtrackd/commit/424042c551f0621fdef8237158d7702071ebfedf))

## [0.3.1](https://github.com/protomated/youtrackd/compare/youtrackd-v0.3.0...youtrackd-v0.3.1) (2026-04-02)


### Bug Fixes

* show all projects in filter bar and sync tray badge with active filters ([74ca359](https://github.com/protomated/youtrackd/commit/74ca3597fa08153e6f0f90f242ca2b967a779f12))

## [0.3.0](https://github.com/protomated/youtrackd/compare/youtrackd-v0.2.5...youtrackd-v0.3.0) (2026-04-02)


### Features

* persist read state across restarts, add pin comments, fix Windows launch ([a3cc7c0](https://github.com/protomated/youtrackd/commit/a3cc7c0968aaf7f958db7f2c4178f8bc57a9e37c))


### Bug Fixes

* **release:** auto-publish draft releases after builds complete ([fb6c18a](https://github.com/protomated/youtrackd/commit/fb6c18a1c6ab658c2e7d314a14315f44ca4dd656))
* **tray:** catch panic when tray position unavailable on Linux ([385c351](https://github.com/protomated/youtrackd/commit/385c3518b6b572343791234973335ba3da982de9)), closes [#6](https://github.com/protomated/youtrackd/issues/6)

## [0.2.5](https://github.com/protomated/youtrackd/compare/youtrackd-v0.2.4...youtrackd-v0.2.5) (2026-03-28)


### Bug Fixes

* **notification:** filter out current user's own activities ([c6b65fc](https://github.com/protomated/youtrackd/commit/c6b65fcc24550d06f2b0fce35aa9d9c6fa2d55c5))

## [0.2.4](https://github.com/protomated/youtrackd/compare/youtrackd-v0.2.3...youtrackd-v0.2.4) (2026-02-16)


### Bug Fixes

* **notification:** update unread count calculation to use filtered activities ([a2ef837](https://github.com/protomated/youtrackd/commit/a2ef83794fff01f7f0d8e92fb436e804fea326ba))

## [0.2.3](https://github.com/protomated/youtrackd/compare/youtrackd-v0.2.2...youtrackd-v0.2.3) (2026-02-14)


### Bug Fixes

* **notification:** update empty state and read activity handling ([5c7bd76](https://github.com/protomated/youtrackd/commit/5c7bd76337d6b8b6afae76942aebf6225264dfd0))

## [0.2.2](https://github.com/protomated/youtrackd/compare/youtrackd-v0.2.1...youtrackd-v0.2.2) (2026-02-14)


### Bug Fixes

* **release:** regenerate signing key and add workflow_dispatch support ([c0bc000](https://github.com/protomated/youtrackd/commit/c0bc00042c2fa2e773d0970ad8f9b16e48d1fe51))

## [0.2.1](https://github.com/protomated/youtrackd/compare/youtrackd-v0.2.0...youtrackd-v0.2.1) (2026-02-12)


### Bug Fixes

* **tray:** update badge and mark-all-read functionality ([f6f9ae7](https://github.com/protomated/youtrackd/commit/f6f9ae7a70e2a8efd903b29b3346f9e4423dcde2))

## [0.2.0](https://github.com/protomated/youtrackd/compare/youtrackd-v0.1.0...youtrackd-v0.2.0) (2026-02-12)


### Features

* initial work to allow connection to YouTrack ([2fd5e21](https://github.com/protomated/youtrackd/commit/2fd5e216f0fc6f62e38fccd9ee3315fc0a17da90))
* **notification:** add OS notifications for new activities and update dependencies ([a9d7833](https://github.com/protomated/youtrackd/commit/a9d7833bf23b4364d142b98e183e14d3f995624c))
* **notification:** add OS notifications for new activities and update dependencies ([74e84b1](https://github.com/protomated/youtrackd/commit/74e84b15224718e107d52afbfc62180a5d6b58ab))
* **notification:** conditionally send OS notifications and add shortcut handling ([5f5a5fb](https://github.com/protomated/youtrackd/commit/5f5a5fbf0c48e10fadcdb46bb5409022af4d8522))
* **tray:** implement tray app behavior and autostart support ([d229b31](https://github.com/protomated/youtrackd/commit/d229b31d832283fed431d26e51697ca585ca581c))


### Bug Fixes

* **settings:** adjust spacing and padding in settings UI ([af8bf55](https://github.com/protomated/youtrackd/commit/af8bf55764f88bc37d66444b065ef5db5e077d9e))
