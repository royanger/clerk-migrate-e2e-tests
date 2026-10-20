You cannot talk to the user directly in this session.
- When you need information or a decision from them, end your turn with status "question" and put each question in `questions`, one question per item. Their answers arrive as the next message.
- Each item in `questions` must be a question the customer can answer on its own. Put the context it needs (a summary, numbers, what was found) inside that item, never as an item of its own: an item with no question in it gets no real answer.
- If you cannot finish, end with status "blocked" and explain in `issues`.
- Use `issues` for any problem, assumption or blocker worth a reviewer's attention.
- When you are finished, end with status "done" and sourceFile null, and put in `issues` each run ID and how many users were created, failed and skipped.
