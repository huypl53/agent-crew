## Future features
- [x] track token usage of each agent if possible. Now I focus on claude code and codex only
- [x] sharing task list, context? Should we?
- [x] dashboard enhance for water fall tracing tasks, session of agents
- [x] in dashboard, I want to have the ability to see the details tasks, tasks of each agent.... I want much more intuitive visualization. These features are big, new branch for him
- [x] clear the worker session when task done, send command `/clear`
- [ ] right now agents that use polling to track lower-level agents cost lot of token on tracking, think about a better solution to minize cost
- [ ] Switch to CLI tool for usage cost reduce. This is huge change, do this in new branch with strict test and UAT
- [x] check the memory leak when an agent disconnect but still showing active in dashboard
- [ ] in the dashboard, I can revoke worker is I want. Of course, I want to have more control over the tasks, the actors
