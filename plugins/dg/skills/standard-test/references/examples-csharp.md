# Test Examples — C#

xUnit, AutoFixture, NSubstitute, and Moq idioms (.NET 8/9, xUnit v2/v3).

---

## 1. Exercise real production code

```csharp
// bad
[Fact]
public void Tax_Calculation_Bad()
{
    decimal price = 100m;
    decimal tax = price * 0.2m; // duplicated from TaxCalculator
    Assert.Equal(20m, tax);
}

// good
[Fact]
public void Calculate_ReturnsCorrectTax()
{
    var sut = new TaxCalculator(rate: 0.20m);
    Assert.Equal(20m, sut.Calculate(price: 100m));
}
```

---

## 2. No unconditional or placeholder assertions

```csharp
// bad
[Fact]
public void ParseDate_Bad()
{
    Assert.True(true); // tautological; or empty body with // TODO
}

// good
[Fact]
public void ParseDate_ValidIso8601_ReturnsParsedDate()
{
    var result = DateParser.Parse("2024-03-15");
    Assert.Equal(new DateOnly(2024, 3, 15), result);
}
```

---

## 3. Builders/factories and generators

```csharp
// bad
[Fact]
public void Approve_Admin_Succeeds_Bad()
{
    var user = new User
    {
        Id = Guid.NewGuid(), Name = "Alice", Email = "alice@example.com",
        Role = "admin", CreatedAt = DateTime.UtcNow, IsActive = true
    };
    Assert.True(new AccessPolicy().CanApprove(user));
}

// good — AutoFixture builds noise fields; only the relevant property is pinned
[Fact]
public void Approve_AdminRole_Succeeds()
{
    var user = new Fixture()
        .Build<User>()
        .With(x => x.Role, "admin")
        .Create();

    Assert.True(new AccessPolicy().CanApprove(user));
}
```

---

## 4. Test through the public interface

```csharp
// bad — reflection into private internals
[Fact]
public void Cache_Stores_Entry_Bad()
{
    var cache = new ResponseCache();
    cache.Store("k", "v");
    var field = typeof(ResponseCache).GetField(
        "_store", BindingFlags.NonPublic | BindingFlags.Instance);
    var store = (Dictionary<string, string>)field!.GetValue(cache)!;
    Assert.True(store.ContainsKey("k"));
}

// good — NSubstitute (Moq equivalent: Mock.Of<T>())
[Fact]
public void Cache_StoredEntry_IsReturnedByFetch()
{
    var cache = new ResponseCache(Substitute.For<IMetrics>());
    cache.Store("k", "v");
    Assert.Equal("v", cache.Fetch("k"));
}
```

---

## 5. Share setup

```csharp
// bad — identical builder block copied into every test method
[Fact]
public void Send_ValidEmail_Queues_Bad()
{
    var mailer = new Mailer(
        new SmtpOptions { Host = "localhost", Port = 25 },
        Substitute.For<ILogger<Mailer>>(),
        Substitute.For<IQueue>());
    // ...
}

// good — xUnit builds a new test class instance per test, so the constructor gives each test its own sut and substitute
namespace MyApp.Tests;

public sealed class MailerTests
{
    private readonly IQueue _queue = Substitute.For<IQueue>();
    private readonly Mailer _mailer;

    public MailerTests() =>
        _mailer = new Mailer(
            new SmtpOptions { Host = "localhost", Port = 25 },
            Substitute.For<ILogger<Mailer>>(),
            _queue);

    [Fact]
    public void Send_ValidEmail_EnqueuesMessage()
    {
        _mailer.Send(new Email("to@example.com", "Hello"));
        _queue.Received(1).Enqueue(Arg.Any<Email>());
    }
}
```

Keep `IClassFixture` for read-only setup. A fixture that holds a substitute collects calls from every test in the class.

---

## 6. Assert on derived values

```csharp
// bad — hardcoded format literal breaks if separator or padding changes
[Fact]
public void FormatInvoiceId_Bad()
{
    var invoice = new Invoice { Id = 42, IssuedAt = new DateTime(2024, 3, 15) };
    Assert.Equal("INV-2024-0042", InvoiceFormatter.FormatId(invoice));
}

// good — derive expected by round-tripping through the public formatter
[Fact]
public void FormatInvoiceId_RoundTrips()
{
    var invoice = new Invoice { Id = 42, IssuedAt = new DateTime(2024, 3, 15) };
    var formatted = InvoiceFormatter.FormatId(invoice);
    Assert.Equal(invoice.Id, InvoiceFormatter.ParseId(formatted).Id);
}
```

---

## 7. Red is local-only

```csharp
// bad — TDD class name suffix and skip attribute committed to repo
namespace MyApp.Tests;

public class CurrencyFormatterRedTests
{
    [Fact(Skip = "not yet implemented")]
    public void Format_UsdAmount_Red()
    {
        Assert.Equal("$1,234.56", CurrencyFormatter.Format(1234.56m, "USD"));
    }
}

// good — test passes, class and method reflect behavior, no TDD artifacts
namespace MyApp.Tests;

public class CurrencyFormatterTests
{
    [Fact]
    public void Format_UsdAmount_IncludesSymbolAndGroupingSeparator()
    {
        Assert.Equal("$1,234.56", CurrencyFormatter.Format(1234.56m, "USD"));
    }
}
```

---

## 8. Name tests after code, not the plan

```csharp
// bad
namespace MyApp.Tests;

public class Slice3Tests
{
    [Fact] public void PROJ_1042_Test() { /* ... */ }
    [Fact] public void SprintWork_UserStory7() { /* ... */ }
}

// good — class mirrors the module; methods state subject + scenario + outcome
namespace MyApp.Tests;

public class PasswordValidatorTests
{
    [Theory]
    [InlineData("short")]
    [InlineData("no-digit")]
    public void Validate_WeakPassword_ReturnsFalse(string password)
        => Assert.False(new PasswordValidator().Validate(password));

    [Fact]
    public void Validate_StrongPassword_ReturnsTrue()
        => Assert.True(new PasswordValidator().Validate("C0rrect!Horse#Battery"));
}
```
