# pi-straw-boss, unreleased

## GUI

- Quit tower works for the tower the sb server runs (the tower service). It has no pi session to ask, so the page's Quit tower used to answer "The session did not answer; close it in its terminal." and closed nothing. It now ends the service as `close-tower` does: the tower's tab closes and the base's mains become members.
- A base or a squad with a service tower closes again: the service's identity was asked to quit like a pi session, got no answer, and refused the whole batch.
- While the sb server's service waits for a resident tower that still holds the workspace, the page shows that resident tower, not the service: its own comms, terminal, composer, and Quit tower. Before, a base whose tower was a resident pi session showed as a service tower, so the page could not reach the resident's session (Quit tower failed, the composer's text went to a queue nobody read, and the terminal said no run was live).
- A quit that gets no answer from the session says it may run an older pi-straw-boss, or be stuck, and suggests `/reload`.
