import gql from "graphql-tag";
import {
  OPTION_GROUP_SUMMARIES_FRAGMENT,
  OPTION_QUANTITY_FRAGMENT,
} from "./fragments";

// Top-level spread + nested spread, all via ${CONST} interpolation from
// another file. The extension must inline both fragments before showing the
// Query Structure analysis, otherwise the spread fields appear as "missing".
export const OPTION_LIST_PAGE_QUERY = gql`
  ${OPTION_QUANTITY_FRAGMENT}
  ${OPTION_GROUP_SUMMARIES_FRAGMENT}
  query OptionListPage($baseDate: String) {
    ...OptionGroupSummariesFragment
    optionStats(baseDate: $baseDate) {
      ...OptionQuantityFragment
    }
  }
`;
