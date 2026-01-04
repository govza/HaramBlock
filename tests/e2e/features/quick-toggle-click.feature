@quick-toggle-click
Feature: Quick Toggle Click Functionality
  Test that clicking the eye toggle cycles: null → blocked → visible → null

  @unsafe
  Scenario: Eye toggle cycles visibility on unsafe image
    Given I set the global policy to "process"
    And quick toggle "unsafe" is "enabled"
    When I go to the "not-safe" basic gallery with "1" "medium" images
    And I wait for image processing
    Then the first image should be masked
    And the first image should not be blacklisted
    When I hover over the first gallery image
    And I click the eye toggle icon
    Then the first image should not be masked
    And the first image should be blacklisted
    When I click the eye toggle icon
    Then the first image should not be masked
    And the first image should not be blacklisted
    When I click the eye toggle icon
    Then the first image should be masked
    And the first image should not be blacklisted

  @safe
  Scenario: Eye toggle cycles visibility on safe image
    Given I set the global policy to "process"
    And quick toggle "safe" is "enabled"
    When I go to the "safe" basic gallery with "1" "medium" images
    And I wait for image processing
    Then the first image should not be masked
    And the first image should not be blacklisted
    When I hover over the first gallery image
    And I click the eye toggle icon
    Then the first image should not be masked
    And the first image should be blacklisted
    When I click the eye toggle icon
    Then the first image should not be masked
    And the first image should not be blacklisted
    When I click the eye toggle icon
    Then the first image should not be masked
    And the first image should not be blacklisted
