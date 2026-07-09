# Recipe: GitHub Issue Context

Use this when triaging, reproducing, or checking whether an issue has already been implemented.

## Sources

```txt
GitHubIssueSource       issue title/body/labels
GitHubCommentSource     selected comments
GitHubRepoSource        README and repo metadata
GitHubCommitSource      recent commits
GitHubPullRequestSource recent merged PRs
CodeFileSource          ranked snippets from selected files
```

## Pipeline

```txt
issue body/comments
+ README
+ recent commits
+ merged PRs
+ ranked code files
-> BM25 or hybrid lexical selection
-> untrusted pack
-> cite issue/comment/file/commit/PR refs
```

## Boundary

Context Nugget should assemble context and citations. The app or GitHub Action decides whether to label, comment, close, reopen, or assign issues.
