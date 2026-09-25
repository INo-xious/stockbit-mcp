# ADR-0014: Read a community post using Stockbit's POST detail endpoint

Status: Accepted, 2026-09-24.

The existing `stream_post_detail` tool sent GET to `/stream/v3/post/:postId`. An authenticated read returned HTTP 405. The current public Stockbit web bundle (module 96641, `39214-3f0e9d9c6f924c91.js`) implements `getStreamDetail(id)` as a POST to that exact path with no request body. Publishing a community post uses the separate `/stream/write` route, which remains absent from our allowed route table.

Change only `streamPost` to the literal POST detail route on `exodus.stockbit.com`, using the normal main-session credential and existing numeric post-id validation. The MCP tool remains annotated read-only; callers cannot supply a message body or choose a different endpoint. Replies and attachments remain response data, never executable instructions.

The response is cached using the requested post ID. HTTP or schema errors are returned through the existing error formatter; no alternative posting route or mutation fallback is attempted. Tests assert the actual outgoing POST has no body, invalid IDs never reach the network, and the route belongs to the explicit read-shaped POST class.
