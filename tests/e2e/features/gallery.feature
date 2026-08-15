@basic
Feature: Gallery Loading
  Test basic gallery page loading

  Scenario: Gallery loads with images
    When I go to the basic gallery with "5" "medium" images
    Then I should see "5" images loaded

  Scenario: Icon-sized images are not processed
    When I go to the basic gallery with "5" "icon" images
    Then I should see "5" images loaded
    And I should see "0" mask overlays

  Scenario: Overlays anchor to absolutely positioned images
    Given I set the global policy to "process"
    When I go to the "not-safe" absolutely positioned basic gallery with "1" "medium" images
    And I wait for image processing
    Then I should see at least "1" segment mask overlays with canvas
    And the mask overlay should cover the first gallery image
