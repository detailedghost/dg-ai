namespace Dg.Hooks.Engine;

public sealed class ContextSink
{
    private readonly List<string> _texts = [];

    public string? EventName { get; private set; }

    public bool IsEmpty => _texts.Count == 0;

    public string Joined => string.Join('\n', _texts);

    public void Add(string eventName, string text)
    {
        if (text.Length == 0)
            return;
        EventName ??= eventName;
        _texts.Add(text);
    }
}
