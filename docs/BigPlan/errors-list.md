1. when new session starts and I input new prompt, it apears in the middle of the chat frame. ![alt text](image.png)
2. sometimes when I quit the session and start a new one via "minima" --> it opens the last session instead of a new one.
3. Pls you must to have regression tests for all fix/feat, because a lot of times TUI is not working properly after some fix/feat implemented in the repo (I am referring to you and not minima agent)
4. M2.4 — Bypass: never persisted --> after the "/mode bypass" command, it is not in the Shift+Tab ring; Different from the expected behavior.
5. M2.9 — acceptEdits is cwd-scoped --> It still passed the prompt ![alt text](image-1.png) it failed
6. M2.12 — Sub-agents + /tree --> it is busy ![alt text](image-2.png), so I can not do "/tree" command during the whole time execution. I want you to fix the "busy" state and able to do "/tree" command during the execution. If possible to implememnt the same process as Claude Code with queue propmt system, so I can do "/tree" command during the execution and que next prompts too. But "/tree" command works, but I am not sure if its cost metrics is working ![alt text](image-3.png)
7. M2.14 — Abort semantics --> I aborted it with Esc in mid session, but it gave me a different error (rounting offline) ![alt text](image-4.png)
8. M2.16 — Small keys sweep --> Not automatically checks / chooses models that are competable with reasoning levels ![alt text](image-5.png)
9. M3.2 — Enter plan mode + council --> plan mode does not take arguments like that, pls fix it![alt text](image-6.png)
10. When using websearch tool, the cost is not calculated in the ToC, pls find the root cause and fix it ![alt text](image-7.png)
11. The auto accept seems not working when choosing the option with Finalize Plan and Accept Edits option ![alt text](image-8.png) ![alt text](image-9.png)
12. Investigate the cause of this issue related to the plan ignorance in this case ![alt text](image-10.png). After finding the issue, pls fix it.
13. The cost in /why or Ctrl+G are not working, pls fix ![alt text](image-11.png)
14. Pls investigate this issue with inability to use the tool in the a local repo ![alt text](image-12.png)
15. M5.10 — /compact + /clear --> /compact is not working --> it shows the same output as another /compact output in another session. ![alt text](image-13.png). Also, /clear is broken, it does not clear the chat and just half pastes the new session MINIMA intro screen, pls fix it so it starts from a clean session page![alt text](image-14.png)
