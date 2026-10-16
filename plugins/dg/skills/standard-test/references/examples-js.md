# Test Examples — JavaScript / TypeScript

Jest, Vitest, and React Testing Library idioms.

---

## 1. Exercise real production code

```ts
// bad
it('formats price', () => {
  const format = (n: number) => `$${n.toFixed(2)}`; // re-implements production logic
  expect(format(9.5)).toBe('$9.50');
});

// good
import { formatPrice } from '../src/currency';

it('formats price', () => {
  expect(formatPrice(9.5)).toBe('$9.50');
});
```

---

## 2. No unconditional or placeholder assertions

```ts
// bad
it('processes order', async () => {
  await processOrder(buildOrder());
  expect(true).toBe(true); // always passes
});

// good
it('processes order', async () => {
  const order = buildOrder({ quantity: 3, unitPrice: 10 });
  const result = await processOrder(order);
  expect(result.total).toBe(30);
});
```

---

## 3. Builders/factories and generators

```ts
// bad
it('rejects underage user', () => {
  const user = { id: '1', name: 'Alice', email: 'alice@example.com', age: 16, role: 'member' };
  expect(canPurchaseAlcohol(user)).toBe(false);
});

// good
import { faker } from '@faker-js/faker';

function buildUser(overrides?: Partial<User>): User {
  return {
    id: faker.string.uuid(),
    name: faker.person.fullName(),
    email: faker.internet.email(),
    age: faker.number.int({ min: 18, max: 80 }),
    role: 'member',
    ...overrides,
  };
}

it('rejects underage user', () => {
  expect(canPurchaseAlcohol(buildUser({ age: 16 }))).toBe(false);
});
```

---

## 4. Test through the public interface

```ts
// bad
it('stores session token', () => {
  const auth = new AuthService();
  auth.login('alice', 'secret');
  expect((auth as any)._tokenCache.get('alice')).toBeDefined(); // private internals
});

// good
it('stores session token', () => {
  const auth = new AuthService();
  auth.login('alice', 'secret');
  expect(auth.getToken('alice')).toBeDefined();
});
```

---

## 5. Share setup

```ts
// bad — duplicated provider tree in every test file
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrapper = ({ children }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

// good — src/test-utils/render.tsx
export function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    queryClient,
    ...render(ui, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    }),
  };
}

// in every test file — RTL v14: always call userEvent.setup() before the render
import { renderWithProviders } from '../test-utils/render';
import userEvent from '@testing-library/user-event';

it('submits the form', async () => {
  const user = userEvent.setup();
  renderWithProviders(<LoginForm />);
  await user.type(screen.getByLabelText('Email'), 'alice@example.com');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(screen.getByRole('status')).toBeInTheDocument();
});
```

---

## 6. Assert on derived values

```ts
// bad
it('displays created date', () => {
  const user = buildUser({ createdAt: new Date('2024-03-15T10:00:00Z') });
  render(<UserCard user={user} />);
  expect(screen.getByText('March 15, 2024')).toBeInTheDocument(); // hardcoded locale output
});

// good
import { formatDate } from '../src/utils/date';

it('displays created date', () => {
  const user = buildUser({ createdAt: new Date('2024-03-15T10:00:00Z') });
  render(<UserCard user={user} />);
  expect(screen.getByText(formatDate(user.createdAt))).toBeInTheDocument();
});
```

---

## 7. Red is local-only

```ts
// bad — skip-decorated or .red. filename marker committed to the repo

// currency-formatter.red.test.ts
it.skip('rounds half-up to two decimal places', () => {
  expect(formatPrice(1.005)).toBe('$1.01');
});

// good — fix the production code first, commit the test without any marker

// currency-formatter.test.ts
it('rounds half-up to two decimal places', () => {
  expect(formatPrice(1.005)).toBe('$1.01');
});
```

---

## 8. Name tests after code, not the plan

```ts
// bad
describe('Slice 1 - AUTH-42', () => {
  it('works correctly', () => {
    expect(hashPassword('hunter2')).toBeTruthy();
  });
});

// good
describe('hashPassword', () => {
  it('returns a bcrypt hash for a valid password', () => {
    expect(hashPassword('hunter2')).toMatch(/^\$2[ab]\$\d+\$/);
  });

  it('throws when password exceeds 72 bytes', () => {
    expect(() => hashPassword('x'.repeat(73))).toThrow(RangeError);
  });
});
```
