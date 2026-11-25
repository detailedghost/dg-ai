using Dg.Hooks.Shared;

namespace Dg.Hooks.Tests;

public sealed class JsTextTests
{
    [Theory]
    [InlineData(0, "0")]
    [InlineData(42, "42")]
    [InlineData(-7.5, "-7.5")]
    [InlineData(100, "100")]
    [InlineData(0.000001, "0.000001")]
    [InlineData(0.0000001, "1e-7")]
    [InlineData(1.5e-7, "1.5e-7")]
    [InlineData(123456789012345680000.0, "123456789012345680000")]
    [InlineData(9007199254740993.0, "9007199254740992")]
    [InlineData(1e21, "1e+21")]
    [InlineData(1.2345e25, "1.2345e+25")]
    [InlineData(-1e21, "-1e+21")]
    [InlineData(0.1, "0.1")]
    [InlineData(double.NaN, "NaN")]
    [InlineData(double.PositiveInfinity, "Infinity")]
    [InlineData(double.NegativeInfinity, "-Infinity")]
    public void Format_Number_MatchesJavaScriptToString(double value, string expected) =>
        Assert.Equal(expected, JsText.Format(value));

    [Fact]
    public void Format_NegativeZero_PrintsZeroLikeJavaScript() => Assert.Equal("0", JsText.Format(double.NegativeZero));
}
