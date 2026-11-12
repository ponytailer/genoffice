# GenOffice Privacy

Last updated: November 12, 2026

GenOffice opens, edits, and saves documents locally. Document editing does not
upload files to GenOffice. AI features require a network connection and send
requests only when you use them.

## Search reranking (off by default)

File search runs on this device: the index is built from your local files, is
queried locally, and is never uploaded. If you turn on **Search reranking** in
Settings, every search also sends one request to the decision-model endpoint you
selected. That request contains:

- the query text
- up to 20 excerpts (at most 1,200 characters each), with each excerpt's file
  name and the name of its parent folder

Excerpts are document content, so they leave the device whenever reranking is
enabled. The request is capped at 24 KB and the reply at 1 MB; judgements are
cached in memory for 30 minutes. If the endpoint fails or times out, the local
ranking is used unchanged.

Selecting a local endpoint — Kev, Rizzo Flow, or a custom URL on this machine —
keeps that request on the device. A custom URL pointing at a server you host
sends the excerpts to that server instead of a vendor. Turning **Search
reranking** off stops these requests entirely.

## Usage analytics

This build sends no usage analytics. There is no measurement endpoint, no
install identifier, no session identifier and no event stream: nothing about
how you use the app leaves the machine, and Settings carries no reporting
switch because there is nothing to switch off.

Older packaged releases shipped opt-out Google Analytics 4 reporting. It was
removed together with the switch that controlled it, so upgrading needs no
action from you.

## Network requests

The only outbound requests are the ones the app needs to do what you asked:

- **AI features** send your prompt (and any text or attachment you explicitly
  include) to the model endpoint you are signed in to or configured yourself.
  Nothing is sent while you are not using them.
- **Update checks** fetch the release manifest (`latest*.yml`) of this build's
  update channel when one is configured, and download an installer only after
  you accept it. A build without a configured channel makes no such request.

## Data collected

None. The app keeps its settings, recent-file list and any cached AI metadata
in a local configuration directory on your machine, and never transmits them.
