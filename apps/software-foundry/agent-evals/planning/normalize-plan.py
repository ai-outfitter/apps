"""Decode the agent's final answer without inventing or repairing plan content."""
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

directory = Path(sys.argv[1])
answer = (directory / "completion.txt").read_text().strip()
if answer.startswith("<goal>"):
    doc = ET.fromstring("<plan>" + answer + "</plan>")
    plan = {
        "goal": doc.findtext("goal"),
        "requirements": [
            {
                **{key: row.findtext(key) for key in ["key", "title", "statement"]},
                "acceptanceCriteria": [c.text for c in row.findall("acceptanceCriteria/c")],
                "dependsOn": row.findtext("dependsOn").split(),
                "target": dict(row.find("target").attrib),
            }
            for row in doc.findall("requirements/requirement")
        ],
        "milestones": [
            {"title": row.findtext("title"), "keys": [k.text for k in row.findall("keys/key")]}
            for row in doc.findall("milestones/milestone")
        ],
        "citations": [c.text for c in doc.findall("citations/citation")],
        "gaps": [g.text for g in doc.findall("gaps/gap")],
    }
else:
    plan = json.loads(answer.removeprefix("```json").removesuffix("```"))
(directory / "plan.json").write_text(json.dumps(plan, indent=2, ensure_ascii=False) + "\n")
