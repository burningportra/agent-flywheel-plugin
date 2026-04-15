# Skill With Followed Phrase

When deciding the next step, ask the user which path to take.

```ts
AskUserQuestion({
  questions: [
    {
      question: "Which path?",
      header: "Path",
      multiSelect: false,
      options: [
        { label: "A", description: "first" },
        { label: "B", description: "second" }
      ]
    }
  ]
})
```
