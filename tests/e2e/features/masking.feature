@masking
Feature: Image Masking
  Test segment mask overlays

  Scenario: Segment mask masks unsafe images
    Given I set the global policy to "process"
    When I go to the "not-safe" basic gallery with "1" "medium" images
    And I wait for image processing
    Then I should see at least "1" segment mask overlays with canvas

  Scenario: Segment mask on large images
    Given I set the global policy to "process"
    When I go to the "not-safe" basic gallery with "3" "large" images
    And I wait for image processing
    Then I should see at least "1" segment mask overlays with canvas

  Scenario: Safe images are not masked
    Given I set the global policy to "process"
    When I go to the "safe" basic gallery with "5" "medium" images
    And I wait for image processing
    Then I should see "0" mask overlays
