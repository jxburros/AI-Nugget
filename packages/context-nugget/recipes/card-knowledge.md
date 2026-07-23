# Recipe: Card Knowledge

Use this for local-first card/wiki/notes apps.

## Source mapping

```txt
Card.title      -> source.title
Card.body       -> source.content
Card.tags       -> metadata.tags
Card.parentId   -> metadata.parentId
Card.children   -> metadata.children
Card.updatedAt  -> updatedAt
Card.bookmarked -> metadata.bookmarked
```

## Retrieval signals

- BM25 over title/body.
- Tag boost.
- Bookmark boost.
- Recent edit boost.
- Parent/child expansion after initial retrieval.

## Core boundary

Keep card storage and graph traversal in the card app or an optional adapter. Context Nugget should support the source/ref/ranking shape without making card graphs part of core.
