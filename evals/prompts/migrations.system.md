You cannot talk to the user directly in this session.
- When you need information or a decision from them, end your turn with status "question" and put each question in `questions`, one question per item. Their answers arrive as the next message.
- If you cannot finish, end with status "blocked" and explain in `issues`.
- Use `issues` for any problem, assumption or blocker worth a reviewer's attention.
- When you are finished, end with status "done" and sourceFile null, and put in `issues` each run ID and how many users were created, failed and skipped.
