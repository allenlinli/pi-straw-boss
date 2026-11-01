# pi-straw-boss, unreleased

## GUI

- Quit tower works for the tower the sb server runs (the tower service). It has no pi session to ask, so the page's Quit tower used to answer "The session did not answer; close it in its terminal." and closed nothing. It now ends the service as `close-tower` does: the tower's tab closes and the base's mains become members.
- A base or a squad with a service tower closes again, also while a run's pi (a boss conversation, an event run, a hand run) sits in the tower's pane: the service's identity and that pi are not asked to quit, the service ends with the tab or base, and its runs end with it. A pi that is working still refuses the close. A stash refuses a base whose tower is the service, since a pop cannot bring back its queue and conversation.
- While the sb server's service waits for a resident tower that still holds the workspace, the page shows that resident tower, not the service: its own comms, terminal, composer, and Quit tower. Before, a base whose tower was a resident pi session showed as a service tower, so the page could not reach the resident's session (Quit tower failed, the composer's text went to a queue nobody read, and the terminal said no run was live).
- A quit that gets no answer from the session says it may run an older pi-straw-boss, or be stuck, and suggests `/reload`.

## Page

- A sheet or dialog that opens while the connect overlay is up (a Quit or Pop that failed after the stream dropped) is usable again; it no longer has dead buttons.
- The public demo restores itself a few seconds after "drop stream" or "go silent", since the overlay covers the demo's toolbar.
