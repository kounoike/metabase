import _ from "underscore";

import { createAction } from "redux-actions";
import { handleActions, combineReducers, createThunkAction } from "metabase/lib/redux";
import { push } from "react-router-redux";

import MetabaseAnalytics from "metabase/lib/analytics";
import MetabaseSettings from "metabase/lib/settings";

import { MetabaseApi } from "metabase/services";

const RESET = "metabase/admin/databases/RESET";
const SELECT_ENGINE = "metabase/admin/databases/SELECT_ENGINE";
export const FETCH_DATABASES = "metabase/admin/databases/FETCH_DATABASES";
const INITIALIZE_DATABASE = "metabase/admin/databases/INITIALIZE_DATABASE";
const ADD_SAMPLE_DATASET = "metabase/admin/databases/ADD_SAMPLE_DATASET";
const SAVE_DATABASE = "metabase/admin/databases/SAVE_DATABASE";
export const DELETE_DATABASE = "metabase/admin/databases/DELETE_DATABASE";
const SYNC_DATABASE = "metabase/admin/databases/SYNC_DATABASE";

export const reset = createAction(RESET);

// selectEngine (uiControl)
export const selectEngine = createAction(SELECT_ENGINE);

// fetchDatabases
export const fetchDatabases = createThunkAction(FETCH_DATABASES, function() {
    return async function(dispatch, getState) {
        try {
            return await MetabaseApi.db_list();
        } catch(error) {
            console.error("error fetching databases", error);
        }
    };
});

// initializeDatabase
export const initializeDatabase = createThunkAction(INITIALIZE_DATABASE, function(databaseId) {
    return async function(dispatch, getState) {
        if (databaseId) {
            try {
                return await MetabaseApi.db_get({"dbId": databaseId});
            } catch (error) {
                if (error.status == 404) {
                    //$location.path('/admin/databases/');
                } else {
                    console.error("error fetching database", databaseId, error);
                }
            }
        } else {
            return {
                name: '',
                engine: Object.keys(MetabaseSettings.get('engines'))[0],
                details: {},
                created: false
            }
        }
    }
})


// addSampleDataset
export const addSampleDataset = createThunkAction(ADD_SAMPLE_DATASET, function() {
    return async function(dispatch, getState) {
        try {
            let sampleDataset = await MetabaseApi.db_add_sample_dataset();
            MetabaseAnalytics.trackEvent("Databases", "Add Sample Data");
            return sampleDataset;
        } catch(error) {
            console.error("error adding sample dataset", error);
            return error;
        }
    };
});

const START_ADD_DATABASE = 'metabase/admin/databases/START_ADD_DATABASE'
const startAddDatabase = createAction(START_ADD_DATABASE)

// saveDatabase
export const saveDatabase = createThunkAction(SAVE_DATABASE, function(database, details) {
    return async function(dispatch, getState) {
        let savedDatabase, formState;

        try {
            //$scope.$broadcast("form:reset");
            database.details = details;
            if (database.id) {
                //$scope.$broadcast("form:api-success", "Successfully saved!");
                savedDatabase = await MetabaseApi.db_update(database);
                MetabaseAnalytics.trackEvent("Databases", "Update", database.engine);
            } else {
                //$scope.$broadcast("form:api-success", "Successfully created!");
                //$scope.$emit("database:created", new_database);
                dispatch(startAddDatabase(database))
                dispatch(push('/admin/databases'))
                savedDatabase = await MetabaseApi.db_create(database);
                MetabaseAnalytics.trackEvent("Databases", "Create", database.engine);

                // update the db metadata already here because otherwise there will be a gap between "Adding..." status
                // and seeing the db that was just added
                await dispatch(fetchDatabases())
                dispatch(push('/admin/databases?created='+savedDatabase.id));
            }

            // this object format is what FormMessage expects:
            formState = { formSuccess: { data: { message: "Successfully saved!" }}};

        } catch (error) {
            //$scope.$broadcast("form:api-error", error);
            console.error("error saving database", error);
            MetabaseAnalytics.trackEvent("Databases", database.id ? "Update Failed" : "Create Failed", database.engine);
            formState = { formError: error };
        }

        return {
            database: savedDatabase,
            formState
        }
    };
});

const START_DELETE_DATABASE = 'metabase/admin/databases/START_DELETE_DATABASE'
const startDeleteDatabase = createAction(START_DELETE_DATABASE)


// deleteDatabase
export const deleteDatabase = createThunkAction(DELETE_DATABASE, function(databaseId, redirect=true) {
    return async function(dispatch, getState) {
        try {
            dispatch(startDeleteDatabase(databaseId))
            dispatch(push('/admin/databases/'));
            await MetabaseApi.db_delete({"dbId": databaseId});
            MetabaseAnalytics.trackEvent("Databases", "Delete", redirect ? "Using Detail" : "Using List");
            return databaseId;
        } catch(error) {
            console.log('error deleting database', error);
        }
    };
});

// syncDatabase
export const syncDatabase = createThunkAction(SYNC_DATABASE, function(databaseId) {
    return function(dispatch, getState) {
        try {
            let call = MetabaseApi.db_sync_metadata({"dbId": databaseId});
            MetabaseAnalytics.trackEvent("Databases", "Manual Sync");
            return call;
        } catch(error) {
            console.log('error syncing database', error);
        }
    };
});


// reducers

const databases = handleActions({
    [FETCH_DATABASES]: { next: (state, { payload }) => payload },
    [ADD_SAMPLE_DATASET]: { next: (state, { payload }) => payload ? [...state, payload] : state },
    [DELETE_DATABASE]: { next: (state, { payload }) => payload ? _.reject(state, (d) => d.id === payload) : state }
}, null);

const editingDatabase = handleActions({
    [RESET]: { next: () => null },
    [INITIALIZE_DATABASE]: { next: (state, { payload }) => payload },
    [SAVE_DATABASE]: { next: (state, { payload }) => payload.database || state },
    [DELETE_DATABASE]: { next: (state, { payload }) => null },
    [SELECT_ENGINE]: { next: (state, { payload }) => ({...state, engine: payload }) }
}, null);

const adds = handleActions({
    [START_ADD_DATABASE]: {
        next: (state, { payload }) => state.concat([payload])
    },
    [SAVE_DATABASE]: {
        next: (state, { payload }) => state.filter((db) => db.name !== payload.database.name)
    }
}, []);

const deletes = handleActions({
    [START_DELETE_DATABASE]: {
        next: (state, { payload }) => state.concat([payload])
    },
    [DELETE_DATABASE]: {
        next: (state, { payload }) => state.filter((dbId) => dbId !== payload)
    }
}, []);

const DEFAULT_FORM_STATE = { formSuccess: null, formError: null };
const formState = handleActions({
    [RESET]: { next: () => DEFAULT_FORM_STATE },
    [SAVE_DATABASE]: { next: (state, { payload }) => payload.formState }
}, DEFAULT_FORM_STATE);

export default combineReducers({
    databases,
    editingDatabase,
    formState,
    adds,
    deletes
});
