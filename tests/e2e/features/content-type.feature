@content-type
Feature: Non-HTML Content Types
  Extension should not cause errors on non-HTML content types

  Background:
    Given I start capturing extension console errors

  Scenario: PDF page loads without extension errors
    When I open a webpage "https://haramblock.com/test/sample.pdf"
    Then there should be no HaramBlock console errors

  Scenario: XML page loads without extension errors
    When I open a webpage "https://haramblock.com/test/sample.xml"
    Then there should be no HaramBlock console errors

  Scenario: Plain text page loads without extension errors
    When I open a webpage "https://haramblock.com/test/sample.txt"
    Then there should be no HaramBlock console errors

  Scenario: JSON page loads without extension errors
    When I open a webpage "https://haramblock.com/test/sample.json"
    Then there should be no HaramBlock console errors
