# GenOffice Privacy

Last updated: October 28, 2026

GenOffice opens, edits, and saves documents locally. Document editing does not
upload files to GenOffice. AI features require a network connection and send
requests only when you use them.

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
