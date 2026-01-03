@quick-toggle
Feature: Quick Toggle Eye Icon
  Test that eye icon appears/hides on hover based on quick toggle settings

  Scenario: Eye icon appears on unsafe image when unsafe toggle is enabled
    Given I set the global policy to "process"
    And quick toggle "unsafe" is "enabled"
    When I go to the "not-safe" basic gallery with "1" "medium" images
    And I wait for image processing
    And I hover over the first gallery image
    Then I should see the eye toggle icon

  Scenario: Eye icon does not appear on unsafe image when unsafe toggle is disabled
    Given I set the global policy to "process"
    And quick toggle "unsafe" is "disabled"
    When I go to the "not-safe" basic gallery with "1" "medium" images
    And I wait for image processing
    And I hover over the first gallery image
    Then I should not see the eye toggle icon

  Scenario: Eye icon appears on safe image when safe toggle is enabled
    Given I set the global policy to "process"
    And quick toggle "safe" is "enabled"
    When I go to the "safe" basic gallery with "1" "medium" images
    And I wait for image processing
    And I hover over the first gallery image
    Then I should see the eye toggle icon

  Scenario: Eye icon does not appear on safe image when safe toggle is disabled
    Given I set the global policy to "process"
    And quick toggle "safe" is "disabled"
    When I go to the "safe" basic gallery with "1" "medium" images
    And I wait for image processing
    And I hover over the first gallery image
    Then I should not see the eye toggle icon

  Scenario: Eye icon auto-hides after timeout on unsafe image
    Given I set the global policy to "process"
    And quick toggle "unsafe" is "enabled"
    When I go to the "not-safe" basic gallery with "1" "medium" images
    And I wait for image processing
    And I hover over the first gallery image
    Then I should see the eye toggle icon
    When I wait for the eye toggle to auto-hide
    Then I should not see the eye toggle icon

  Scenario: Eye icon auto-hides after timeout on safe image
    Given I set the global policy to "process"
    And quick toggle "safe" is "enabled"
    When I go to the "safe" basic gallery with "1" "medium" images
    And I wait for image processing
    And I hover over the first gallery image
    Then I should see the eye toggle icon
    When I wait for the eye toggle to auto-hide
    Then I should not see the eye toggle icon
