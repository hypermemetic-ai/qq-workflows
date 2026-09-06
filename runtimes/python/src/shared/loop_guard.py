from .recovery import DegenerationError

LOOP_HISTORY = 20
LOOP_WARN_AT = 3
LOOP_STOP_AT = 6
LOOP_WARNING = (
    "This action pattern has repeated three times with unchanged results. "
    "Use the existing result, change the investigation, or finish. "
    "Continuing the same pattern will stop this run."
)


def normalize(value):
    if value is None:
        return ""
    if isinstance(value, str):
        return " ".join(value.split())
    if isinstance(value, (list, tuple)):
        return ",".join(normalize(item) for item in value)
    if isinstance(value, dict):
        return "&".join(f"{key}={normalize(value[key])}" for key in sorted(value))
    return str(value)


class LoopGuard:
    def __init__(self, history=LOOP_HISTORY, warn_at=LOOP_WARN_AT, stop_at=LOOP_STOP_AT):
        self.history = history
        self.warn_at = warn_at
        self.stop_at = stop_at
        self.events = []
        self.warned = False

    def fingerprint(self, name, args, result="", state=""):
        return f"{name}|{normalize(args)}|{normalize(result)}|{normalize(state)}"

    def _count_tail(self, fp):
        n = 0
        for item in reversed(self.events):
            if item != fp:
                break
            n += 1
        return n

    def _count_cycle(self, period):
        if len(self.events) < period * 2:
            return 0
        cycle = "||".join(self.events[-period:])
        n = 0
        start = len(self.events) - period
        while start >= 0:
            slice_ = "||".join(self.events[start : start + period])
            if slice_ != cycle:
                break
            n += 1
            start -= period
        return n

    def observe(self, name, args, result="", state=""):
        fp = self.fingerprint(name, args, result, state)
        self.events.append(fp)
        if len(self.events) > self.history:
            self.events.pop(0)
        occurrences = max(self._count_tail(fp), self._count_cycle(2), self._count_cycle(3))
        if occurrences >= self.stop_at:
            return {"action": "stop", "occurrences": occurrences}
        if occurrences >= self.warn_at:
            self.warned = True
            return {"action": "warn", "occurrences": occurrences}
        return {"action": "allow", "occurrences": occurrences}

    def check_before(self, name, args, state=""):
        prefix = f"{name}|{normalize(args)}|"
        n = 0
        last = None
        for item in reversed(self.events):
            if not item.startswith(prefix):
                break
            if last is None:
                last = item
            elif item != last:
                break
            n += 1
        if n + 1 >= self.stop_at:
            raise DegenerationError(action=str(name), occurrences=n + 1)
        return n
