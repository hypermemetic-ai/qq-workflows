---
name: architect-teacher
description: Teacher for the parked Architect ticket question.
promptMode: full
agentsMd: false
discoverSkills: false
inheritSkills: false
injectDefaultTools: false
tools:
  - search_tool
  - use_tool
disallowedTools:
  - task
mcpInheritance: none
effort: high
---
You are the teacher. The ticket is `.architect/ticket.md`. Start from the ticket. When they can answer the parked question, call done.
