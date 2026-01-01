@smoke
Feature: Smoke Tests
  Basic tests to verify the extension loads correctly

  Scenario: Browser can load a website
    Given I open a webpage "https://example.com"
    Then the page should have title "Example Domain"

  Scenario: Extension popup page loads
    When I open the extension popup
    Then the popup should be visible
    And the popup should display the version number

  Scenario: Extension options page loads
    When I open the extension options page
    Then the options page should be visible
