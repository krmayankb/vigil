"""Triage: what an item on the triage queue is, and which workflow takes it.

``classify`` says what an item is -- an activity class, how sure, and why.
``routes`` maps an activity class to a workflow, and so to the plugin the agent
runs it on. ``decide`` puts the two together and is what the daemon records on
the intake row, so the console can show why each item went where it did.
"""
