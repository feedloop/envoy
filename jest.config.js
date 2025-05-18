module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  transform: {
    '^.+\\\.tsx?$': ['ts-jest', {
      // You can specify ts-jest options here, for example:
      // tsconfig: 'tsconfig.json', // or a specific tsconfig for tests if you have one
      // isolatedModules: true, // Can sometimes speed up transpilation
    }]
  },
  clearMocks: true,
  coverageDirectory: "coverage",
  coverageProvider: "v8",
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
}; 