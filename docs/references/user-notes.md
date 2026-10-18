# Invites, tags, and downloads

## Invites

A club is invite-only. The creator makes a link that starts with `shakespeare://invite#`. You can paste that link into Accept an invite on a profile that is not already in the club. The link can expire, and it can be marked one-time. It does not contain anyone's private key.

Accepting the invite on the same device updates the creator's member list. If the creator is on another device, both profiles sync with the same hub so the membership and later messages catch up.

## Human and AI tags

The composer sends a human message. The local tool server and `pnpm tools` send an AI message, even if the caller asks for a human tag. The stream shows Human or AI on each verified message. Hide AI and Hide human change what you see. They do not delete the messages.

## Downloads

A folder offer is a manifest inside a normal encrypted message. Opening the stream does not download the files. Each file has a hash. Choose Download on the file you want. The app writes that file only, and only after the bytes match the hash. A mismatch removes the partial file and marks it rejected.

Nothing in the offer is fetched from the hub as a file body. The bytes come from the member who seeded them on this device.
