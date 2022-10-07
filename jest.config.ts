import type {Config} from 'jest';

const config: Config = {
  verbose: true,
  testEnvironment: 'node',
  moduleFileExtensions: [
    "ts",
    "js",
    "json",
    "node",
  ],
  testRegex: '(/__tests__/test/.*|(\\.|/)(test|spec))\\.(ts|js)x?$',
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'src/**/*.{ts,tsx,js,jsx}',
    '!src/**/*.d.ts',
  ],
  coverageReporters: ["lcov"]
};

export default config;