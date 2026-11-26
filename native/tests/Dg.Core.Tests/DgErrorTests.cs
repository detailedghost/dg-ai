using Dg.Core.Errors;

namespace Dg.Core.Tests;

public sealed class DgErrorTests
{
    [Fact]
    public void Format_AllFields_RendersLocationKeyMessageAndNextStep()
    {
        var error = new DgError("config.toml", 12, "config.bad_value", "front.enabled must be a boolean", "Set it to true or false.");

        Assert.Equal(
            "config.toml:12 config.bad_value: front.enabled must be a boolean\nnext: Set it to true or false.",
            error.Format()
        );
    }

    [Fact]
    public void Format_NoLine_OmitsLineSuffix()
    {
        var error = new DgError("plugin.toml", null, "plugin.missing", "name is required", "Add a name key.");

        Assert.StartsWith("plugin.toml plugin.missing:", error.Format());
    }

    [Fact]
    public void ToException_CarriesErrorAndFormattedMessage()
    {
        var error = new DgError("a.toml", 1, "k", "m", "n");

        var exception = error.ToException();

        Assert.Same(error, exception.Error);
        Assert.Equal(error.Format(), exception.Message);
    }
}
